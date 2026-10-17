package sample.c07;
import org.apache.ibatis.annotations.Select;
import org.apache.ibatis.annotations.Update;
import org.apache.ibatis.annotations.Param;
public interface Mapper {
    @Select("SELECT owner_id FROM records WHERE id=#{id}")
    String owner(@Param("id") String id);
    @Update("UPDATE records SET value=#{value} WHERE id=#{id}")
    void update(@Param("id") String id, @Param("value") String value);
}
