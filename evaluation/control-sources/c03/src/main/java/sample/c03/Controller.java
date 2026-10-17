package sample.c03;
import java.security.Principal;
import org.springframework.web.bind.annotation.*;
@RestController
@RequestMapping("/c03")
public class Controller {
    private Mapper mapper;
    @PostMapping("/records")
    public void run(@RequestParam String id, @RequestParam String value, Principal principal) {
        if (!principal.getName().equals(mapper.owner(id))) return;
        mapper.update(id, value);
    }
}
